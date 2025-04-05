import { type NextRequest, NextResponse } from "next/server"
import { chromium } from "playwright"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { v4 as uuidv4 } from "uuid"

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
})

export async function POST(request: NextRequest) {
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

    // Launch browser with specific configuration for Vercel
    const browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    })
    const page = await browser.newPage()

    try {
      // Set viewport size
      await page.setViewportSize({ width: 1920, height: 1080 })

      // Navigate to the URL
      await page.goto(url, { waitUntil: "networkidle" })

      // If clickSelector is provided, click the element and wait for navigation
      if (clickSelector) {
        const clickLocator = page.locator(clickSelector).first()
        await clickLocator.waitFor({ state: "visible", timeout: 10000 })
        await clickLocator.click()
        // wait for action have been completed
        await page.waitForTimeout(5000)
        // Wait for navigation to complete
        await page.waitForLoadState("networkidle")
      }

      // If selector is provided, take screenshot of specific element
      let screenshot: Buffer | null = null
      if (selector) {
        const locator = page.locator(selector).first()
        try {
          console.log(`Waiting for element ${selector} to become visible...`)
          await locator.waitFor({ state: "visible", timeout: 30000 }) // Increased timeout to 30 seconds
          console.log(`Element ${selector} is now visible`)

          await locator.scrollIntoViewIfNeeded()
          console.log(`Scrolled element ${selector} into view`)

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
          screenshot = await locator.screenshot({
            type: "png",
            scale: "device",
            omitBackground: true,
          })

          // Restore visibility of all elements
          await page.evaluate(() => {
            const elements = document.querySelectorAll("*")
            elements.forEach((el) => {
              ;(el as HTMLElement).style.visibility = "visible"
            })
          })
        } catch (error) {
          console.error(`Error while waiting for element ${selector}:`, error)
          // If the element exists but is not visible, try to take screenshot anyway
          if ((await locator.count()) > 0) {
            console.log(
              `Element ${selector} exists but may not be visible, attempting screenshot anyway`
            )
          } else {
            throw new Error(`Element ${selector} not found on the page`)
          }
        }
      } else {
        // Take full page screenshot if no selector is provided
        screenshot = await page.screenshot({
          type: "png",
          fullPage: true,
        })
      }

      // Generate a unique filename
      const filename = `${uuidv4()}.png`
      const bucketName = process.env.S3_BUCKET_NAME || ""

      if (!screenshot) {
        throw new Error("Failed to capture screenshot")
      }

      // Upload to S3
      const uploadParams = {
        Bucket: bucketName,
        Key: filename,
        Body: screenshot,
        ContentType: "image/png",
      }

      await s3Client.send(new PutObjectCommand(uploadParams))

      // Generate the S3 URL
      const s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${filename}`

      return NextResponse.json({
        success: true,
        screenshotUrl: s3Url,
      })
    } finally {
      await browser.close()
    }
  } catch (error) {
    console.error("Error taking screenshot:", error)
    return NextResponse.json(
      { error: "Failed to take screenshot" },
      { status: 500 }
    )
  }
}
