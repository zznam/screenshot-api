import { type NextRequest, NextResponse } from "next/server"
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

    // Parse the request body
    const { content, format = "json", filename } = await request.json()

    if (!content) {
      return NextResponse.json(
        { error: "Missing required parameter: content" },
        { status: 400 }
      )
    }

    // Determine content type based on format
    let contentType = "application/json"
    let fileExtension = "json"

    switch (format.toLowerCase()) {
      case "json":
        contentType = "application/json"
        fileExtension = "json"
        break
      case "txt":
        contentType = "text/plain"
        fileExtension = "txt"
        break
      case "html":
        contentType = "text/html"
        fileExtension = "html"
        break
      case "markdown":
      case "md":
        contentType = "text/markdown"
        fileExtension = "md"
        break
      default:
        return NextResponse.json(
          { error: `Unsupported format: ${format}` },
          { status: 400 }
        )
    }

    // Generate a unique filename if not provided
    const uniqueFilename = filename
      ? `${filename}.${fileExtension}`
      : `${uuidv4()}.${fileExtension}`

    const bucketName = process.env.S3_BUCKET_NAME || ""

    // Prepare content for upload
    let uploadContent = content
    if (format.toLowerCase() === "json" && typeof content === "object") {
      // If content is an object and format is JSON, stringify it
      uploadContent = JSON.stringify(content, null, 2)
    }

    // Upload to S3
    const uploadParams = {
      Bucket: bucketName,
      Key: uniqueFilename,
      Body: uploadContent,
      ContentType: contentType,
    }

    await s3Client.send(new PutObjectCommand(uploadParams))

    // Generate the S3 URL
    const s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${uniqueFilename}`

    return NextResponse.json({
      success: true,
      documentUrl: s3Url,
      filename: uniqueFilename,
    })
  } catch (error) {
    console.error("Error uploading document:", error)
    return NextResponse.json(
      { error: "Failed to upload document" },
      { status: 500 }
    )
  }
}
