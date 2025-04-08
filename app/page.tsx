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
                {result.screenshotUrl && (
                  <Image
                    src={result.screenshotUrl}
                    alt="Screenshot"
                    width={1000}
                    height={1000}
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
