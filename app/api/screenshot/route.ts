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
    const { url, selector, selectorType } = await request.json()

    if (!url || !selector || !selectorType) {
      return NextResponse.json({ error: "Missing required parameters: url, selector, selectorType" }, { status: 400 })
    }

    if (selectorType !== "className" && selectorType !== "id") {
      return NextResponse.json({ error: 'selectorType must be either "className" or "id"' }, { status: 400 })
    }

    // Launch browser
    const browser = await chromium.launch()
    const page = await browser.newPage()

    try {
      // Navigate to the URL
      await page.goto(url, { waitUntil: "networkidle" })

      // Find the element based on selector type
      const locator = selectorType === "className" ? page.locator(`.${selector}`) : page.locator(`#${selector}`)

      // Wait for the element to be visible
      await locator.waitFor({ state: "visible", timeout: 10000 })

      // Scroll element into view if needed
      await locator.scrollIntoViewIfNeeded()

      // Take screenshot of the element
      const screenshot = await locator.screenshot()

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

