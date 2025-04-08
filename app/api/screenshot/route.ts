import { type NextRequest, NextResponse } from "next/server"
import { Browser, chromium } from "playwright"
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
    let browser: Browser | null = null
    const controller = new AbortController()
    const requestId = uuidv4() // Generate a unique ID for this request
    console.log(`[${requestId}] Starting screenshot request`)
    
    const timeout = setTimeout(() => {
      controller.abort()
      if (browser) {
        browser.close()
      }
      console.log(`[${requestId}] Request timed out after 60 seconds`)
    }, 60000)

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
        console.error(`[${requestId}] Missing environment variables:`, missingEnvVars)
        return NextResponse.json(
          {
            error: "Missing required environment variables",
            details: missingEnvVars,
          },
          { status: 500 }
        )
      }
      const { url, selector, clickSelector } = await request.json()
      console.log(`[${requestId}] Request parameters:`, { url, selector, clickSelector })

      if (!url) {
        console.log(`[${requestId}] Missing required parameter: url`)
        return NextResponse.json(
          { error: "Missing required parameter: url" },
          { status: 400 }
        )
      }

      // Launch browser with specific configuration for Vercel
      console.log(`[${requestId}] Launching browser...`)
      browser = await chromium.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        executablePath:
          process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      })
      let page = await browser.newPage()
      console.log(`[${requestId}] Browser launched successfully`)

      try {
        // Set viewport size
        await page.setViewportSize({ width: 1920, height: 1080 })

        // Navigate to the URL with optimized wait strategy
        console.log(`[${requestId}] Navigating to URL: ${url}`)
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        })
        console.log(`[${requestId}] Page loaded successfully`)

        // If clickSelector is provided, click the element and wait for navigation
        if (clickSelector) {
          console.log(`[${requestId}] Clicking element: ${clickSelector}`)
          const clickLocator = page.locator(clickSelector).first()
          await clickLocator.waitFor({ state: "visible", timeout: 10000 })
          await clickLocator.click()
          // Handle new page if opened
          const context = browser.contexts()[0]
          const pages = context.pages()
          if (pages.length > 1) {
            page = pages[pages.length - 1]
            await page.waitForLoadState("domcontentloaded", { timeout: 10000 })
          }
          await page.waitForTimeout(10000)
          console.log(`[${requestId}] Waiting for navigation after click`)
          await page.waitForLoadState("networkidle", { timeout: 10000 })
          console.log(`[${requestId}] Navigation completed after click`)
        }

        // If selector is provided, take screenshot of specific element
        let screenshot: Buffer | null = null
        if (selector) {
          console.log(`[${requestId}] Taking screenshot of element: ${selector}`)
          const locator = page.locator(selector).first()
          try {
            console.log(`[${requestId}] Waiting for element ${selector} to become visible...`)
            await locator.waitFor({ state: "visible", timeout: 10000 })
            console.log(`[${requestId}] Element ${selector} is now visible`)

            await locator.scrollIntoViewIfNeeded()
            console.log(`[${requestId}] Scrolled element ${selector} into view`)

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
            console.log(`[${requestId}] Element screenshot captured`)

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
            console.log(`[${requestId}] Screenshot optimized`)

            // Restore visibility of all elements
            await page.evaluate(() => {
              const elements = document.querySelectorAll("*")
              elements.forEach((el) => {
                ;(el as HTMLElement).style.visibility = "visible"
              })
            })
          } catch (error) {
            console.error(`[${requestId}] Error while waiting for element ${selector}:`, error)
            if ((await locator.count()) > 0) {
              console.log(
                `[${requestId}] Element ${selector} exists but may not be visible, attempting screenshot anyway`
              )
            } else {
              throw new Error(`[${requestId}] Element ${selector} not found on the page`)
            }
          }
        } else {
          console.log(`[${requestId}] Taking full page screenshot`)
          const rawScreenshot = await page.screenshot({
            type: "png",
            fullPage: true,
          })
          console.log(`[${requestId}] Full page screenshot captured`)

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
          console.log(`[${requestId}] Screenshot optimized`)
        }

        // Generate a unique filename
        const filename = `${uuidv4()}.png`
        const bucketName = process.env.S3_BUCKET_NAME || ""
        console.log(`[${requestId}] Generated filename: ${filename}`)

        if (!screenshot) {
          console.error(`[${requestId}] Failed to capture screenshot`)
          throw new Error("Failed to capture screenshot")
        }

        // Upload to S3
        console.log(`[${requestId}] Uploading to S3 bucket: ${bucketName}`)
        const uploadParams = {
          Bucket: bucketName,
          Key: filename,
          Body: screenshot,
          ContentType: "image/png",
        }

        await s3Client.send(new PutObjectCommand(uploadParams))
        console.log(`[${requestId}] Upload completed successfully`)

        // Generate the S3 URL
        const s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${filename}`
        console.log(`[${requestId}] Request completed successfully. Screenshot URL: ${s3Url}`)

        return NextResponse.json({
          success: true,
          screenshotUrl: s3Url,
        })
      } finally {
        clearTimeout(timeout)
        await browser?.close()
        console.log(`[${requestId}] Browser closed`)
      }
    } catch (error) {
      clearTimeout(timeout)
      if (error instanceof Error && error.name === "AbortError") {
        console.error(`[${requestId}] Operation timed out after 60 seconds`)
        return NextResponse.json(
          { error: "Operation timed out after 60 seconds" },
          { status: 408 }
        )
      }
      console.error(`[${requestId}] Error taking screenshot:`, error)
      return NextResponse.json(
        { error: "Failed to take screenshot" },
        { status: 500 }
      )
    }
  })
}
