'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import VoiceButton from '../components/VoiceButton'
import StatusPanel from '../components/StatusPanel'
import TicketList from '../components/TicketList'
import { speak, cancelSpeech } from '../lib/tts'

const WELCOME_MESSAGE =
  'Welcome to ServiceNow Voice Assistant. Press Space or the microphone button to speak. ' +
  'You can say things like: create a ticket for my laptop is not working, ' +
  'list my tickets, resolve ticket, or update a ticket.'

export default function Home() {
  const [status, setStatus] = useState('idle') // idle | recording | processing | success | error
  const [transcript, setTranscript] = useState('')
  const [response, setResponse] = useState('')
  const [tickets, setTickets] = useState([])
  const [loadingTickets, setLoadingTickets] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const hasWelcomed = useRef(false)

  // Announce to screen readers via live region
  const announce = useCallback((msg) => {
    setAnnouncement('')
    setTimeout(() => setAnnouncement(msg), 50)
  }, [])

  useEffect(() => {
    if (!hasWelcomed.current) {
      hasWelcomed.current = true
      setTimeout(() => speak(WELCOME_MESSAGE), 800)
    }
  }, [])

  // Space bar triggers mic (keyboard accessible)
  useEffect(() => {
    const handleKey = (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') {
        e.preventDefault()
        if (status === 'idle') startRecording()
        else if (status === 'recording') stopRecording()
      }
      if (e.code === 'Escape') {
        cancelSpeech()
        if (status === 'recording') stopRecording()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [status])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        await processAudio(blob)
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      setStatus('recording')
      announce('Recording started. Speak your command now.')
      speak('Listening...')
    } catch {
      setStatus('error')
      setResponse('Microphone access denied. Please allow microphone access and try again.')
      speak('Microphone access denied.')
      announce('Error: Microphone access denied.')
    }
  }, [status])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && status === 'recording') {
      mediaRecorderRef.current.stop()
      setStatus('processing')
      announce('Processing your voice command.')
      speak('Processing...')
    }
  }, [status])

  const processAudio = async (blob) => {
    try {
      // Step 1: Transcribe with Whisper
      const formData = new FormData()
      formData.append('audio', blob, 'recording.webm')

      const transcribeRes = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      })

      if (!transcribeRes.ok) throw new Error('Transcription failed')
      const { text } = await transcribeRes.json()
      setTranscript(text)
      announce(`You said: ${text}`)

      // Step 2: Classify intent + execute action
      const intentRes = await fetch('/api/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })

      if (!intentRes.ok) throw new Error('Intent processing failed')
      const result = await intentRes.json()

      setResponse(result.message)
      setStatus(result.success ? 'success' : 'error')
      speak(result.message)
      announce(result.message)

      // Refresh ticket list after mutations
      if (result.refreshTickets) {
        loadTickets()
      }
    } catch (err) {
      const msg = 'Sorry, something went wrong. Please try again.'
      setStatus('error')
      setResponse(msg)
      speak(msg)
      announce(msg)
    }
  }

  const loadTickets = useCallback(async () => {
    setLoadingTickets(true)
    announce('Loading your tickets.')
    try {
      const res = await fetch('/api/servicenow/tickets')
      const data = await res.json()
      setTickets(data.tickets || [])
      announce(`Loaded ${data.tickets?.length ?? 0} tickets.`)
    } catch {
      announce('Failed to load tickets.')
    } finally {
      setLoadingTickets(false)
    }
  }, [])

  const reset = () => {
    setStatus('idle')
    setTranscript('')
    setResponse('')
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Skip link target */}
      <div id="main-content" tabIndex={-1} />

      {/* Header */}
      <header className="bg-primary text-white py-5 px-6 shadow-md" role="banner">
        <div className="max-w-4xl mx-auto flex items-center gap-4">
          <span className="text-4xl" aria-hidden="true">🎙️</span>
          <div>
            <h1 className="text-accessible-2xl font-bold leading-tight">
              ServiceNow Voice Assistant
            </h1>
            <p className="text-blue-100 text-accessible-base mt-1">
              Accessible ticket management — speak your commands
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-8">

        {/* Voice command section */}
        <section
          aria-labelledby="voice-section-heading"
          className="bg-white rounded-2xl shadow-md p-8 text-center"
        >
          <h2
            id="voice-section-heading"
            className="text-accessible-xl font-semibold mb-2 text-gray-800"
          >
            Voice Command
          </h2>
          <p className="text-gray-600 text-accessible-base mb-6">
            Press the button or <kbd className="bg-gray-100 px-2 py-1 rounded font-mono text-sm border">Space</kbd> to start speaking.
            Press again or <kbd className="bg-gray-100 px-2 py-1 rounded font-mono text-sm border">Esc</kbd> to stop.
          </p>

          <VoiceButton
            status={status}
            onStart={startRecording}
            onStop={stopRecording}
          />

          {/* Example commands */}
          <div className="mt-8 text-left" aria-labelledby="examples-heading">
            <h3 id="examples-heading" className="text-accessible-base font-semibold text-gray-700 mb-3">
              Example commands you can say:
            </h3>
            <ul className="space-y-2 text-gray-600 text-accessible-base" role="list">
              {[
                '"Create a ticket for my email is not working"',
                '"List my open tickets"',
                '"Resolve ticket INC0001234"',
                '"Update ticket INC0001234 with I have restarted the system"',
                '"What is the status of ticket INC0001234"',
              ].map((cmd) => (
                <li key={cmd} className="flex items-start gap-2">
                  <span className="text-primary font-bold mt-0.5" aria-hidden="true">›</span>
                  <span className="italic">{cmd}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Status panel */}
        <StatusPanel
          status={status}
          transcript={transcript}
          response={response}
          onReset={reset}
        />

        {/* Ticket list */}
        <section aria-labelledby="tickets-heading" className="bg-white rounded-2xl shadow-md p-8">
          <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
            <h2 id="tickets-heading" className="text-accessible-xl font-semibold text-gray-800">
              Your Tickets
            </h2>
            <button
              onClick={loadTickets}
              disabled={loadingTickets}
              className="bg-primary text-white px-5 py-2.5 rounded-lg font-semibold text-accessible-base
                         hover:bg-primary-dark focus-visible:outline focus-visible:outline-3
                         focus-visible:outline-primary disabled:opacity-60 transition-colors"
              aria-label="Refresh ticket list"
            >
              {loadingTickets ? 'Loading...' : 'Refresh Tickets'}
            </button>
          </div>
          <TicketList tickets={tickets} loading={loadingTickets} />
        </section>
      </main>

      {/* ARIA live region — announces to screen readers without visual noise */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>

      {/* Footer */}
      <footer className="mt-12 py-6 text-center text-gray-500 text-sm border-t border-gray-200">
        <p>ServiceNow Voice Assistant — Designed for accessibility</p>
        <p className="mt-1">
          Keyboard shortcuts: <kbd>Space</kbd> to record · <kbd>Esc</kbd> to stop/cancel
        </p>
      </footer>
    </div>
  )
}
