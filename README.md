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

### Login to the server

  ```bash
  ssh -i "zzwin.pem" ubuntu@ec2-52-63-80-2.ap-southeast-2.compute.amazonaws.com
  ```

### Init setup

  ```bash
  git clone https://github.com/zznam/screenshot-api.git
  touch .env.local
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs

  # Install PM2 globally
  sudo npm install -g pm2

  npm install --global yarn

  yarn install

  ```

### Pull the latest code, build and start the server

  ```bash
  cd screenshot-api && git pull && yarn build && pm2 start yarn --name "next-app" -- start && pm2 logs next-app
  ```

### Pull the latest code, build and restart the server

  ```bash
  cd screenshot-api && git pull && yarn build && pm2 reload next-app && pm2 logs next-app
  ```

## Development Links

- UI Screenshot <http://ec2-52-63-80-2.ap-southeast-2.compute.amazonaws.com:3000/>
- UI Store Document <http://ec2-52-63-80-2.ap-southeast-2.compute.amazonaws.com:3000/store-document>
- API Screenshot <http://ec2-52-63-80-2.ap-southeast-2.compute.amazonaws.com:3000/api/screenshot>
- API Store Document <http://ec2-52-63-80-2.ap-southeast-2.compute.amazonaws.com:3000/api/store-document>

### Configure your EC2 security group

Go to EC2 Dashboard
Select your instance
Click on the Security tab
Click on the Security Group
Add a new inbound rule:
Type: Custom TCP
Port: 3000
Source: 0.0.0.0/0 (or your IP for better security)
