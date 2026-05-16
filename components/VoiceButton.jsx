'use client'

const STATUS_CONFIG = {
  idle: {
    label: 'Start Recording',
    icon: '🎙️',
    bg: 'bg-primary hover:bg-primary-dark',
    description: 'Press to begin recording your voice command',
  },
  recording: {
    label: 'Stop Recording',
    icon: '⏹️',
    bg: 'bg-red-600 hover:bg-red-700 recording-pulse',
    description: 'Recording in progress. Press to stop.',
  },
  processing: {
    label: 'Processing...',
    icon: '⏳',
    bg: 'bg-yellow-600',
    description: 'Processing your voice command, please wait',
  },
  success: {
    label: 'Record Again',
    icon: '🎙️',
    bg: 'bg-success hover:bg-green-700',
    description: 'Command completed successfully. Press to record again.',
  },
  error: {
    label: 'Try Again',
    icon: '🎙️',
    bg: 'bg-danger hover:bg-red-800',
    description: 'An error occurred. Press to try again.',
  },
}

export default function VoiceButton({ status, onStart, onStop }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.idle
  const isProcessing = status === 'processing'

  const handleClick = () => {
    if (status === 'recording') onStop()
    else if (!isProcessing) onStart()
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <button
        onClick={handleClick}
        disabled={isProcessing}
        aria-label={cfg.label}
        aria-description={cfg.description}
        aria-pressed={status === 'recording'}
        aria-busy={isProcessing}
        className={`
          ${cfg.bg} text-white rounded-full w-28 h-28 text-5xl
          flex items-center justify-center
          transition-all duration-200
          focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-4
          focus-visible:outline-primary
          disabled:opacity-60 disabled:cursor-not-allowed
          shadow-lg
        `}
      >
        <span aria-hidden="true">{cfg.icon}</span>
      </button>

      <span
        className="text-accessible-base font-semibold text-gray-700"
        aria-live="polite"
        aria-atomic="true"
      >
        {cfg.label}
      </span>
    </div>
  )
}
