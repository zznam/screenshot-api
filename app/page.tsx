"use client"

import type React from "react"
import Image from "next/image"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Loader2 } from "lucide-react"

export default function Home() {
  const [url, setUrl] = useState("")
  const [selector, setSelector] = useState("")
  const [clickSelector, setClickSelector] = useState("")
  const [filename, setFilename] = useState("")
  const [viewportWidth, setViewportWidth] = useState("1280")
  const [viewportHeight, setViewportHeight] = useState("960")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{
    success: boolean
    screenshotUrl?: string
    error?: string
  } | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setResult(null)

    try {
      const response = await fetch("/api/screenshot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          selector: selector || undefined,
          clickSelector: clickSelector || undefined,
          filename: filename || undefined,
          viewportWidth: parseInt(viewportWidth) || 1280,
          viewportHeight: parseInt(viewportHeight) || 960,
        }),
      })

      const data = await response.json()
      setResult(data)
    } catch (error) {
      setResult({ success: false, error: "Failed to process request" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4 md:p-24">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Webpage Screenshot</CardTitle>
          <CardDescription>
            Take screenshots of webpages with optional element selection and
            click actions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="url">Website URL</Label>
              <Input
                id="url"
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="clickSelector">Click Element (optional)</Label>
              <Input
                id="clickSelector"
                placeholder=".button-class, #button-id"
                value={clickSelector}
                onChange={(e) => setClickSelector(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                CSS selector for the element to click before taking the
                screenshot
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="selector">Screenshot Element (optional)</Label>
              <Input
                id="selector"
                placeholder=".my-class, #my-id, div > span"
                value={selector}
                onChange={(e) => setSelector(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                If provided, Playwright will click on the element and take a
                screenshot by the "selector" parameter.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="filename">Filename (optional)</Label>
              <Input
                id="filename"
                placeholder="screenshot"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Custom filename for the screenshot. If not provided, a random UUID will be used.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="viewportWidth">Viewport Width</Label>
                <Input
                  id="viewportWidth"
                  type="number"
                  placeholder="1280"
                  value={viewportWidth}
                  onChange={(e) => setViewportWidth(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="viewportHeight">Viewport Height</Label>
                <Input
                  id="viewportHeight"
                  type="number"
                  placeholder="960"
                  value={viewportHeight}
                  onChange={(e) => setViewportHeight(e.target.value)}
                />
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                "Take Screenshot"
              )}
            </Button>
          </form>
        </CardContent>

        {result && (
          <CardFooter className="flex flex-col items-start">
            {result.success ? (
              <div className="space-y-2 w-full">
                <p className="text-green-600 font-medium">
                  Screenshot captured successfully!
                </p>
                <a
                  href={result.screenshotUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline break-all"
                >
                  {result.screenshotUrl}
                </a>
                {/* show image */}
                {result.screenshotUrl && (
                  <Image
                    src={result.screenshotUrl}
                    alt="Screenshot"
                    width={1920}
                    height={1080}
                  />
                )}
              </div>
            ) : (
              <p className="text-red-600">
                {result.error || "An error occurred"}
              </p>
            )}
          </CardFooter>
        )}
      </Card>
    </main>
  )
}
