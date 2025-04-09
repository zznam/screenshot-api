import { type NextRequest, NextResponse } from "next/server"
import puppeteer, { Page } from "puppeteer"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { v4 as uuidv4 } from "uuid"
import pngquant from "pngquant"

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
    console.log(
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
        console.error("Missing environment variables:", missingEnvVars)
        return NextResponse.json(
          {
            error: "Missing required environment variables",
            details: missingEnvVars,
          },
          { status: 500 }
        )
      }
      const { url, selector, clickSelector } = await request.json()

      if (!url) {
        return NextResponse.json(
          { error: "Missing required parameter: url" },
          { status: 400 }
        )
      }

      // Launch browser with specific configuration for Linux
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920x1080',
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      })

      const page = await browser.newPage()

      try {
        // Set viewport size
        await page.setViewport({ width: 1920, height: 1080 })

        // Navigate to the URL with optimized wait strategy
        await page.goto(url, { waitUntil: "networkidle2" })

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
          await page.waitForSelector(clickSelector, {
            visible: true,
            timeout: 10000,
          })
          // click element
          await page.click(clickSelector)

          // scroll clickSelector into view
          await page.evaluate((sel: string) => {
            const element = document.querySelector(sel)
            if (element) {
              element.scrollIntoView({ behavior: "smooth", block: "center" })
            }
          }, clickSelector)

          // sleep 10s
          await new Promise((resolve) => setTimeout(resolve, 10000))
        }

        // Determine which page to screenshot (original or new)
        let pageToScreenshot

        try {
          // Try to get the new page with a short timeout
          const newPageTimeoutPromise = new Promise<null>((_, reject) => {
            setTimeout(() => reject(new Error("No new page opened")), 1000)
          })

          pageToScreenshot = (await Promise.race([
            newPagePromise,
            newPageTimeoutPromise,
          ])) as Page

          // If we got here, a new page was opened
          // Wait for the new page to load
          await pageToScreenshot
            .waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 })
            .catch(() =>
              console.log("Navigation timeout on new page, continuing anyway")
            )
        } catch (error) {
          // No new page was opened, use the original page
          pageToScreenshot = page
        }
        // If selector is provided, take screenshot of specific element
        let screenshot: Buffer | null = null
        if (selector) {
          try {
            console.log(`Waiting for element ${selector} to become visible...`)
            await pageToScreenshot.waitForSelector(selector, {
              visible: true,
              timeout: 10000,
            })
            console.log(`Element ${selector} is now visible`)

            // Scroll element into view
            await pageToScreenshot.evaluate((sel: string) => {
              const element = document.querySelector(sel)
              if (element) {
                element.scrollIntoView({ behavior: "smooth", block: "center" })
              }
            }, selector)

            // Hide only sibling elements while keeping parent and child elements visible
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
                const walker = document.createTreeWalker(
                  element,
                  NodeFilter.SHOW_ELEMENT,
                  null
                )
                let node: Element | null = walker.nextNode() as Element
                while (node) {
                  if (node !== element) {
                    children.push(node)
                  }
                  node = walker.nextNode() as Element
                }
                return children
              }

              // Get all parent and child elements
              const parents = getParents(targetElement)
              const children = getChildren(targetElement)

              // Hide all elements except the target, its parents, and its children
              const elements = document.querySelectorAll("*")
              elements.forEach((el) => {
                if (
                  el !== targetElement &&
                  !parents.includes(el) &&
                  !children.includes(el)
                ) {
                  ;(el as HTMLElement).style.visibility = "hidden"
                }
              })
            }, selector)

            // Take screenshot of the element
            const element = await pageToScreenshot.$(selector)
            if (!element) {
              throw new Error(`Element ${selector} not found on the page`)
            }

            screenshot = await element.screenshot({
              omitBackground: true,
            })

            // Restore visibility of all elements
            await pageToScreenshot.evaluate(() => {
              const elements = document.querySelectorAll("*")
              elements.forEach((el) => {
                ;(el as HTMLElement).style.visibility = "visible"
              })
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
          throw new Error("Failed to capture screenshot")
        }

        const optimizedImage = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = []
          const stream = new pngquant([
            "256",
            "--quality=70-90",
            "--speed=1",
            "-",
          ])
          stream.on("data", (chunk: Buffer) => chunks.push(chunk))
          stream.on("end", () => resolve(Buffer.concat(chunks)))
          stream.on("error", reject)
          stream.end(screenshot)
        })

        // Generate a unique filename
        const filename = `${uuidv4()}.png`

        try {
          // Upload to S3
          await s3Client.send(
            new PutObjectCommand({
              Bucket: process.env.S3_BUCKET_NAME,
              Key: filename,
              Body: optimizedImage,
              ContentType: "image/png",
            })
          )

          // Return the URL of the uploaded image
          return NextResponse.json({
            success: true,
            screenshotUrl: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${filename}`,
          })
        } catch (error) {
          console.error("Error uploading to S3:", error)
          throw new Error(
            `Failed to upload screenshot to S3: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          )
        }
      } finally {
        if (browser) {
          await browser.close()
        }
        clearTimeout(timeout)
      }
    } catch (error) {
      console.error("Error in screenshot endpoint:", error)
      return NextResponse.json(
        { error: "Failed to capture screenshot", details: error },
        { status: 500 }
      )
    }
  })
}
