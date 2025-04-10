import { type NextRequest, NextResponse } from "next/server"
import { Browser, chromium } from "playwright"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { v4 as uuidv4 } from "uuid"
import pngquant from "pngquant"
import { log, logError } from "@/lib/logger"

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
    let browser: Browser | null = null
    const controller = new AbortController()
    const requestId = uuidv4() // Generate a unique ID for this request
    log(`[${requestId}] Starting screenshot request`)

    const timeout = setTimeout(() => {
      controller.abort()
      if (browser) {
        browser.close()
      }
      log(`[${requestId}] Request timed out after 120 seconds`)
    }, 1000 * 60 * 2)

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
        logError(
          `[${requestId}] Missing environment variables:`,
          missingEnvVars
        )
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
        viewportWidth,
        viewportHeight,
        waitTimeout = 10000,
      } = await request.json()
      log(`[${requestId}] Request parameters:`, {
        url,
        selector,
        clickSelector,
        filename,
        viewportWidth,
        viewportHeight,
        waitTimeout,
      })

      if (!url) {
        log(`[${requestId}] Missing required parameter: url`)
        return NextResponse.json(
          { error: "Missing required parameter: url" },
          { status: 400 }
        )
      }

      // Launch browser with specific configuration for Vercel
      log(`[${requestId}] Launching browser...`)
      browser = await chromium.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        executablePath:
          process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      })
      let page = await browser.newPage()
      log(`[${requestId}] Browser launched successfully`)

      try {
        // Set viewport size with default values
        const width = parseInt(viewportWidth) || 1280
        const height = parseInt(viewportHeight) || 800
        await page.setViewportSize({ width, height })
        log(`[${requestId}] Viewport set to ${width}x${height}`)

        // Navigate to the URL with optimized wait strategy
        log(`[${requestId}] Navigating to URL: ${url}`)
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        })
        log(`[${requestId}] Page loaded successfully`)

        // Wait for the specified timeout after page load
        if (waitTimeout > 0) {
          log(`[${requestId}] Waiting for ${waitTimeout}ms after page load`)
          await page.waitForTimeout(waitTimeout)
        }

        // remove component with id: onetrust-consent-sdk
        await page.evaluate(() => {
          const element = document.getElementById("onetrust-consent-sdk")
          if (element) {
            element.remove()
          }
        })

        // If clickSelector is provided, click the element and wait for navigation
        if (clickSelector) {
          log(`[${requestId}] Clicking element: ${clickSelector}`)
          const clickLocator = page.locator(clickSelector).first()

          // Check if element exists before proceeding
          const elementExists = (await clickLocator.count()) > 0
          if (elementExists) {
            // First ensure the element is in the viewport

            // Wait for element to be visible and stable
            await clickLocator.waitFor({
              state: "visible",
              timeout: 10000,
            })

            // Store initial state before clicking
            await page.evaluate(() => {
              ;(window as any).initialUrl = window.location.href
              ;(window as any).initialBody = document.body.innerHTML
            })

            // Try to click with retry logic
            let clickSuccess = false
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await clickLocator.click({
                  timeout: 5000,
                  force: attempt === 3, // Force click on last attempt
                })
                clickSuccess = true
                break
              } catch (err) {
                log(`[${requestId}] Click attempt ${attempt} failed:`, err)
                if (attempt < 3) {
                  await page.waitForTimeout(1000) // Wait before retry
                }
              }
            }

            if (!clickSuccess) {
              throw new Error(`Failed to click element after 3 attempts`)
            }

            // Handle new page if opened
            const context = browser.contexts()[0]
            const pages = context.pages()
            if (pages.length > 1) {
              page = pages[pages.length - 1]
              await page.waitForLoadState("domcontentloaded", {
                timeout: 10000,
              })
            }

            // Wait for any of these conditions to be met:
            // 1. Network idle
            // 2. DOM changes
            // 3. Specific element appears/disappears
            await Promise.race([
              page.waitForLoadState("networkidle", { timeout: 10000 }),
              page.waitForFunction(
                () => {
                  const currentUrl = window.location.href
                  return currentUrl !== (window as any).initialUrl
                },
                { timeout: 10000 }
              ),
              page.waitForFunction(
                () => {
                  const body = document.body
                  return body && body.innerHTML !== (window as any).initialBody
                },
                { timeout: 10000 }
              ),
            ]).catch(() => {
              log(
                `[${requestId}] No significant page changes detected after click`
              )
            })

            log(`[${requestId}] Navigation completed after click`)
          }
        }

        // If selector is provided, take screenshot of specific element
        let screenshot: Buffer | null = null
        if (selector) {
          log(`[${requestId}] Taking screenshot of element: ${selector}`)
          const locator = page.locator(selector).first()
          try {
            log(
              `[${requestId}] Waiting for element ${selector} to become visible...`
            )
            await locator.waitFor({ state: "visible", timeout: 10000 })
            log(`[${requestId}] Element ${selector} is now visible`)

            await locator.scrollIntoViewIfNeeded()
            log(`[${requestId}] Scrolled element ${selector} into view`)

            // Hide only sibling elements while keeping parent and child elements visible
            await page.evaluate((sel) => {
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
            const rawScreenshot = await locator.screenshot({
              type: "png",
              scale: "device",
              omitBackground: true,
            })
            log(`[${requestId}] Element screenshot captured`)

            // Optimize the screenshot using pngquant
            screenshot = await new Promise<Buffer>((resolve, reject) => {
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
              stream.end(rawScreenshot)
            })
            log(`[${requestId}] Screenshot optimized`)

            // Restore visibility of all elements
            await page.evaluate(() => {
              const elements = document.querySelectorAll("*")
              elements.forEach((el) => {
                ;(el as HTMLElement).style.visibility = "visible"
              })
            })
          } catch (err) {
            logError(
              `[${requestId}] Error while waiting for element ${selector}:`,
              err
            )
            if ((await locator.count()) > 0) {
              log(
                `[${requestId}] Element ${selector} exists but may not be visible, attempting screenshot anyway`
              )
            } else {
              throw new Error(
                `[${requestId}] Element ${selector} not found on the page`
              )
            }
          }
        } else {
          log(`[${requestId}] Taking full page screenshot`)
          const rawScreenshot = await page.screenshot({
            type: "png",
            fullPage: true,
          })
          log(`[${requestId}] Full page screenshot captured`)

          // Optimize the screenshot using pngquant
          screenshot = await new Promise<Buffer>((resolve, reject) => {
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
            stream.end(rawScreenshot)
          })
          log(`[${requestId}] Screenshot optimized`)
        }

        // Generate a unique filename
        const s3Filename = filename ? `${filename}.png` : `${uuidv4()}.png`
        const bucketName = process.env.S3_BUCKET_NAME || ""
        log(`[${requestId}] Generated filename: ${s3Filename}`)

        if (!screenshot) {
          logError(`[${requestId}] Failed to capture screenshot`)
          throw new Error("Failed to capture screenshot")
        }

        // Upload to S3
        log(`[${requestId}] Uploading to S3 bucket: ${bucketName}`)
        const uploadParams = {
          Bucket: bucketName,
          Key: s3Filename,
          Body: screenshot,
          ContentType: "image/png",
        }

        await s3Client.send(new PutObjectCommand(uploadParams))
        log(`[${requestId}] Upload completed successfully`)

        // Generate the S3 URL
        const s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Filename}`
        log(
          `[${requestId}] Request completed successfully. Screenshot URL: ${s3Url}`
        )

        return NextResponse.json({
          success: true,
          screenshotUrl: s3Url,
        })
      } finally {
        clearTimeout(timeout)
        await browser?.close()
        log(`[${requestId}] Browser closed`)
      }
    } catch (err) {
      clearTimeout(timeout)
      if (err instanceof Error && err.name === "AbortError") {
        logError(`[${requestId}] Operation timed out after 60 seconds`)
        return NextResponse.json(
          { error: "Operation timed out after 60 seconds" },
          { status: 408 }
        )
      }
      logError(`[${requestId}] Error taking screenshot:`, err)
      return NextResponse.json(
        { error: "Failed to take screenshot" },
        { status: 500 }
      )
    }
  })
}
