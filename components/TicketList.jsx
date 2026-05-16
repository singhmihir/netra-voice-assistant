'use client'

const PRIORITY_LABELS = { '1': 'Critical', '2': 'High', '3': 'Moderate', '4': 'Low', '5': 'Planning' }
const PRIORITY_COLORS = {
  '1': 'bg-red-100 text-red-800',
  '2': 'bg-orange-100 text-orange-800',
  '3': 'bg-yellow-100 text-yellow-800',
  '4': 'bg-blue-100 text-blue-800',
  '5': 'bg-gray-100 text-gray-700',
}

export default function TicketList({ tickets, loading }) {
  if (loading) {
    return (
      <p className="text-gray-500 text-accessible-base text-center py-8" aria-live="polite" aria-busy="true">
        Loading tickets...
      </p>
    )
  }

  if (tickets.length === 0) {
    return (
      <p className="text-gray-500 text-accessible-base text-center py-8">
        No tickets loaded. Say "list my tickets" or press Refresh.
      </p>
    )
  }

  return (
    <div
      role="list"
      aria-label={`${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`}
      className="space-y-4"
    >
      {tickets.map((ticket) => (
        <article
          key={ticket.number}
          role="listitem"
          aria-label={`Ticket ${ticket.number}: ${ticket.short_description}`}
          className="border border-gray-200 rounded-xl p-5 bg-gray-50 hover:bg-white
                     transition-colors focus-within:ring-2 focus-within:ring-primary"
        >
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex-1">
              <div className="flex items-center gap-3 flex-wrap mb-2">
                <span className="font-mono font-bold text-primary text-accessible-base">
                  {ticket.number}
                </span>
                <span className={`text-sm font-semibold px-2.5 py-0.5 rounded-full ${PRIORITY_COLORS[ticket.priority] ?? 'bg-gray-100 text-gray-700'}`}>
                  {PRIORITY_LABELS[ticket.priority] ?? `P${ticket.priority}`}
                </span>
                <span className="text-sm font-medium text-gray-600 bg-white border border-gray-200 px-2.5 py-0.5 rounded-full">
                  {ticket.state}
                </span>
              </div>
              <p className="text-accessible-base text-gray-800 font-medium leading-snug">
                {ticket.short_description}
              </p>
              {ticket.assigned_to && (
                <p className="text-sm text-gray-500 mt-1">
                  Assigned to: {ticket.assigned_to}
                </p>
              )}
            </div>
            <time
              className="text-sm text-gray-400 whitespace-nowrap"
              dateTime={ticket.created}
              aria-label={`Created ${ticket.created}`}
            >
              {ticket.created?.slice(0, 10)}
            </time>
          </div>
        </article>
      ))}
    </div>
  )
}
