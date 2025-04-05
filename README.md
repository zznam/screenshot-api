# Screenshot API

A Next.js API endpoint that captures screenshots of web pages and stores them in AWS S3. This API allows you to take screenshots of entire pages or specific elements using CSS selectors.

## Features

- Capture full-page screenshots or specific elements
- Support for clicking elements before taking screenshots
- Automatic upload to AWS S3
- Configurable viewport size
- Element isolation for cleaner screenshots

## Prerequisites

- Node.js (v14 or later)
- AWS account with S3 access
- Playwright dependencies

## Environment Variables

Create a `.env.local` file in the root directory with the following variables:

```env
AWS_REGION=your-aws-region
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
S3_BUCKET_NAME=your-bucket-name
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium (optional)
```

## Installation

1. Clone the repository
2. Install dependencies:

    ```bash
    npm install
    ```

3. Set up your environment variables
4. Install Playwright browsers:

    ```bash
    npx playwright install chromium
    ```

## API Usage

Send a POST request to `/api/screenshot` with the following JSON body:

```json
{
  "url": "https://example.com",
  "selector": "#element-id", // optional
  "clickSelector": ".button-class" // optional
}
```

### Parameters

- `url` (required): The URL of the webpage to screenshot
- `selector` (optional): CSS selector for a specific element to capture
- `clickSelector` (optional): CSS selector for an element to click before taking the screenshot

### Response

```json
{
  "success": true,
  "screenshotUrl": "https://your-bucket.s3.region.amazonaws.com/filename.png"
}
```

## Error Handling

The API returns appropriate error responses with status codes:

- 400: Missing required parameters
- 500: Server errors or missing environment variables

## Development

To run the development server:

```bash
npm run dev
```

## Deployment

This API is designed to work with Vercel's serverless functions. Deploy to Vercel using:

```bash
vercel
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Deploy Scripts

1. Pull the latest code and restart the server

```bash
yarn pull && yarn build && pm2 reload next-app && pm2 logs next-app
```
