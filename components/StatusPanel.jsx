'use client'

const STYLES = {
  idle: { border: 'border-gray-200', bg: 'bg-gray-50', icon: null },
  recording: { border: 'border-red-300', bg: 'bg-red-50', icon: '🔴' },
  processing: { border: 'border-yellow-300', bg: 'bg-yellow-50', icon: '⏳' },
  success: { border: 'border-green-300', bg: 'bg-green-50', icon: '✅' },
  error: { border: 'border-red-300', bg: 'bg-red-50', icon: '⚠️' },
}

export default function StatusPanel({ status, transcript, response, onReset }) {
  if (status === 'idle') return null

  const { border, bg, icon } = STYLES[status] ?? STYLES.idle

  return (
    <section
      aria-labelledby="status-panel-heading"
      aria-live="polite"
      className={`rounded-2xl border-2 ${border} ${bg} p-6 space-y-4 status-transition`}
    >
      <h2 id="status-panel-heading" className="sr-only">Command Status</h2>

      {transcript && (
        <div>
          <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-1">
            You said:
          </p>
          <blockquote className="text-accessible-lg text-gray-800 italic border-l-4 border-primary pl-4">
            "{transcript}"
          </blockquote>
        </div>
      )}

      {response && (
        <div className="flex items-start gap-3">
          {icon && (
            <span className="text-2xl mt-0.5" aria-hidden="true">{icon}</span>
          )}
          <p className="text-accessible-lg text-gray-800 font-medium leading-relaxed">
            {response}
          </p>
        </div>
      )}

      {(status === 'success' || status === 'error') && (
        <button
          onClick={onReset}
          className="mt-2 text-primary underline text-accessible-base font-semibold
                     hover:text-primary-dark focus-visible:outline focus-visible:outline-2
                     focus-visible:outline-primary rounded"
          aria-label="Clear status and return to ready state"
        >
          Clear
        </button>
      )}
    </section>
  )
}
