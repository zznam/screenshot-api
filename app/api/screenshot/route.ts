import { type NextRequest, NextResponse } from "next/server"
import puppeteer, { Page } from "puppeteer"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { v4 as uuidv4 } from "uuid"
import pngquant from "pngquant"

// Logging helper function
const log = (message: string, data?: any) => {
  const timestamp = new Date().toISOString()
  if (data) {
    console.log(`[${timestamp}] ${message}`, data)
  } else {
    console.log(`[${timestamp}] ${message}`)
  }
}

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
})

// Request queue implementation
class RequestQueue {
  private queue: (() => Promise<void>)[]
  private processing: boolean
  private maxConcurrent: number
  private currentRequests: number

  constructor(maxConcurrent = 5) {
    this.queue = []
    this.processing = false
    this.maxConcurrent = maxConcurrent
    this.currentRequests = 0
  }

  private logQueueStatus() {
    log(
      `Queue Status: ${this.currentRequests} active requests, ${this.queue.length} tasks waiting, ${this.maxConcurrent} max concurrent`
    )
  }

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const task = async () => {
        try {
          this.currentRequests++
          this.logQueueStatus()
          const result = await fn()
          resolve(result)
        } catch (error) {
          reject(error)
        } finally {
          this.currentRequests--
          this.logQueueStatus()
          this.processNext()
        }
      }

      this.queue.push(task)
      this.logQueueStatus()
      this.processNext()
    })
  }

  private processNext() {
    if (
      this.processing ||
      this.queue.length === 0 ||
      this.currentRequests >= this.maxConcurrent
    ) {
      return
    }

    this.processing = true
    const task = this.queue.shift()
    if (task) {
      task().finally(() => {
        this.processing = false
        this.processNext()
      })
    }
  }
}

// Create a global request queue
const requestQueue = new RequestQueue()

export async function POST(request: NextRequest) {
  log("Received new screenshot request")
  return requestQueue.enqueue(async () => {
    let browser: any = null
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
      if (browser) {
        browser.close()
      }
    }, 1000 * 60 * 2) // Reduced timeout to 2 minutes

    try {
      log("Validating environment variables")
      // Validate environment variables
      const requiredEnvVars = [
        "AWS_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "S3_BUCKET_NAME",
      ]
      const missingEnvVars = requiredEnvVars.filter(
        (varName) => !process.env[varName]
      )

      if (missingEnvVars.length > 0) {
        log("Missing environment variables", missingEnvVars)
        return NextResponse.json(
          {
            error: "Missing required environment variables",
            details: missingEnvVars,
          },
          { status: 500 }
        )
      }

      const {
        url,
        selector,
        clickSelector,
        filename,
        viewportWidth = 1280,
        viewportHeight = 960,
      } = await request.json()
      log("Request parameters", {
        url,
        selector,
        clickSelector,
        filename,
        viewportWidth,
        viewportHeight,
      })

      if (!url) {
        log("Missing URL parameter")
        return NextResponse.json(
          { error: "Missing required parameter: url" },
          { status: 400 }
        )
      }

      log("Launching browser")
      // Launch browser with specific configuration for Linux
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      })

      const page = await browser.newPage()
      log("Created new page")

      try {
        log("Setting viewport")
        // Set viewport size
        await page.setViewport({ width: viewportWidth, height: viewportHeight })

        log(`Navigating to URL: ${url}`)
        // Navigate to the URL with optimized wait strategy
        await page
          .goto(url, {
            waitUntil: "networkidle2",
            timeout: 30000, // 30 seconds timeout for navigation
          })
          .catch((error: Error) => {
            log("Navigation timeout", error)
            throw new Error(`Navigation timeout: ${error.message}`)
          })

        // Create a promise that resolves when a new page is created
        const newPagePromise = new Promise((resolve) => {
          browser.once("targetcreated", async (target: any) => {
            const newPage = await target.page()
            if (newPage) resolve(newPage)
          })
        })

        // If clickSelector is provided, click the element and wait for navigation
        const elementExists = clickSelector && (await page.$(clickSelector))
        if (elementExists) {
          log(`Waiting for click selector: ${clickSelector}`)
          await page
            .waitForSelector(clickSelector, {
              visible: true,
              timeout: 15000, // Increased to 15 seconds
            })
            .catch((error: Error) => {
              log("Click selector timeout", error)
              throw new Error(`Click selector timeout: ${error.message}`)
            })

          log(`Clicking element: ${clickSelector}`)
          await page.click(clickSelector)

          log("Scrolling element into view")
          await page.evaluate((sel: string) => {
            const element = document.querySelector(sel)
            if (element) {
              element.scrollIntoView({ behavior: "smooth", block: "center" })
            }
          }, clickSelector)

          log("Waiting 10 seconds after click")
          await new Promise((resolve) => setTimeout(resolve, 10000))
        }

        // Determine which page to screenshot (original or new)
        let pageToScreenshot

        try {
          log("Checking for new page")
          // Try to get the new page with a short timeout
          const newPageTimeoutPromise = new Promise<null>((_, reject) => {
            setTimeout(() => reject(new Error("No new page opened")), 2000) // Reduced to 2 seconds
          })

          pageToScreenshot = (await Promise.race([
            newPagePromise,
            newPageTimeoutPromise,
          ])) as Page

          log("New page detected, waiting for navigation")
          // If we got here, a new page was opened
          // Wait for the new page to load
          await pageToScreenshot
            .waitForNavigation({
              waitUntil: "networkidle2",
              timeout: 15000, // Increased to 15 seconds
            })
            .catch((error) => {
              log("New page navigation timeout", error)
              console.log("Navigation timeout on new page, continuing anyway")
            })
        } catch (error) {
          log("No new page detected, using original page")
          // No new page was opened, use the original page
          pageToScreenshot = page
        }

        // If selector is provided, take screenshot of specific element
        let screenshot: Buffer | null = null
        if (selector) {
          try {
            log(`Waiting for element ${selector} to become visible`)
            await pageToScreenshot.waitForSelector(selector, {
              visible: true,
              timeout: 10000,
            })
            log(`Element ${selector} is now visible`)

            log("Scrolling element into view")
            await pageToScreenshot.evaluate((sel: string) => {
              const element = document.querySelector(sel)
              if (element) {
                element.scrollIntoView({ behavior: "smooth", block: "center" })
              }
            }, selector)

            // Hide only sibling elements while keeping parent and child elements visible
            log("Preparing element for screenshot")
            await pageToScreenshot.evaluate((sel: string) => {
              const targetElement = document.querySelector(sel)
              if (!targetElement) return

              // Function to get all parent elements
              const getParents = (element: Element): Element[] => {
                const parents: Element[] = []
                let current = element.parentElement
                while (current) {
                  parents.push(current)
                  current = current.parentElement
                }
                return parents
              }

              // Function to get all child elements
              const getChildren = (element: Element): Element[] => {
                const children: Element[] = []
                const walk = (node: Element) => {
                  children.push(node)
                  for (const child of Array.from(node.children)) {
                    walk(child)
                  }
                }
                walk(element)
                return children
              }

              const parents = getParents(targetElement)
              const children = getChildren(targetElement)
              const allElements = document.querySelectorAll("*")

              // Hide all elements except parents and children
              allElements.forEach((element) => {
                if (
                  !parents.includes(element) &&
                  !children.includes(element) &&
                  element !== targetElement
                ) {
                  const style = window.getComputedStyle(element)
                  if (style.display !== "none") {
                    const htmlElement = element as HTMLElement
                    htmlElement.dataset.originalDisplay = style.display
                    htmlElement.style.display = "none"
                  }
                }
              })
            }, selector)

            log("Taking screenshot of element")
            screenshot = await pageToScreenshot.screenshot({
              clip: await pageToScreenshot.evaluate((sel: string) => {
                const element = document.querySelector(sel)
                if (!element) return null
                const rect = element.getBoundingClientRect()
                return {
                  x: rect.left,
                  y: rect.top,
                  width: rect.width,
                  height: rect.height,
                }
              }, selector),
            })
          } catch (error) {
            console.error(`Error while waiting for element ${selector}:`, error)
            screenshot = await pageToScreenshot.screenshot({
              type: "png",
              fullPage: true,
            })
          }
        } else {
          // Take full page screenshot if no selector is provided
          screenshot = await pageToScreenshot.screenshot({
            type: "png",
            fullPage: true,
          })
        }

        if (!screenshot) {
          log("Failed to capture screenshot")
          throw new Error("Failed to capture screenshot")
        }

        log("Optimizing screenshot")
        // Optimize the screenshot using pngquant
        const optimizedScreenshot = await new Promise<Buffer>(
          (resolve, reject) => {
            const pngquantStream = new pngquant([
              "256",
              "--quality=60-80",
              "--speed=1",
              "-",
            ])
            const chunks: Buffer[] = []

            pngquantStream.on("data", (chunk: Buffer) => chunks.push(chunk))
            pngquantStream.on("end", () => resolve(Buffer.concat(chunks)))
            pngquantStream.on("error", reject)

            pngquantStream.end(screenshot)
          }
        )

        log("Generating unique filename")
        const finalFilename = `${filename || uuidv4()}.png`

        log("Uploading to S3")
        // Upload to S3
        await s3Client.send(
          new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: finalFilename,
            Body: optimizedScreenshot,
            ContentType: "image/png",
          })
        )
        const screenshotUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${finalFilename}`
        log("Screenshot uploaded successfully", screenshotUrl)
        return NextResponse.json({
          success: true,
          screenshotUrl,
        })
      } finally {
        log("Cleaning up browser")
        if (browser) {
          await browser.close()
        }
        clearTimeout(timeout)
      }
    } catch (error) {
      log("Error in request processing", error)
      return NextResponse.json(
        { error: "Internal server error", details: error },
        { status: 500 }
      )
    }
  })
}
