import './globals.css'

export const metadata = {
  title: 'ServiceNow Voice Assistant',
  description: 'Accessible voice-powered ServiceNow ticket management for blind and visually impaired users',
  viewport: 'width=device-width, initial-scale=1',
  themeColor: '#1a56db',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="application-name" content="ServiceNow Voice Assistant" />
      </head>
      <body className="min-h-screen bg-gray-50">
        {/* Skip navigation link for keyboard users */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  )
}
