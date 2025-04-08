export function log(message: string, ...args: any[]) {
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] ${message}`, ...args)
}

export function logError(message: string, ...args: any[]) {
  const timestamp = new Date().toISOString()
  console.error(`[${timestamp}] ${message}`, ...args)
} 