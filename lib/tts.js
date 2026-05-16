'use client'

// Text-to-speech using the Web Speech API — provides audio feedback for blind users.
// All spoken output goes through this module so it can be cancelled consistently.

let currentUtterance = null

export function speak(text, { rate = 1.0, pitch = 1.0 } = {}) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return

  cancelSpeech()

  const utter = new SpeechSynthesisUtterance(text)
  utter.rate = rate
  utter.pitch = pitch
  utter.volume = 1

  currentUtterance = utter
  window.speechSynthesis.speak(utter)
}

export function cancelSpeech() {
  if (typeof window === 'undefined') return
  window.speechSynthesis?.cancel()
  currentUtterance = null
}
