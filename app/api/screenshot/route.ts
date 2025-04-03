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
    const { url, selector } = await request.json()

    if (!url || !selector) {
      return NextResponse.json({ error: "Missing required parameters: url, selector" }, { status: 400 })
    }

    // Launch browser
    const browser = await chromium.launch()
    const page = await browser.newPage()

    try {
      // Set viewport size
      await page.setViewportSize({ width: 1920, height: 1080 })

      // Navigate to the URL
      await page.goto(url, { waitUntil: "networkidle" })

      // Find the element using the CSS selector
      const locator = page.locator(selector)

      // Wait for the element to be visible
      await locator.waitFor({ state: "visible", timeout: 10000 })

      // Scroll element into view if needed
      await locator.scrollIntoViewIfNeeded()

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
        const elements = document.querySelectorAll('*')
        elements.forEach((el) => {
          if (el !== targetElement && !parents.includes(el) && !children.includes(el)) {
            (el as HTMLElement).style.visibility = 'hidden'
          }
        })
      }, selector)

      // Take screenshot of the element
      const screenshot = await locator.screenshot({
        type: 'png',
        scale: 'device',
        omitBackground: true
      })

      // Restore visibility of all elements
      await page.evaluate(() => {
        const elements = document.querySelectorAll('*')
        elements.forEach((el) => {
          (el as HTMLElement).style.visibility = 'visible'
        })
      })

      // Generate a unique filename
      const filename = `${uuidv4()}.png`
      const bucketName = process.env.S3_BUCKET_NAME || ""

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
    return NextResponse.json({ error: "Failed to take screenshot" }, { status: 500 })
  }
}

