const BASE = process.env.SERVICENOW_INSTANCE_URL
const AUTH = Buffer.from(
  `${process.env.SERVICENOW_USERNAME}:${process.env.SERVICENOW_PASSWORD}`
).toString('base64')

const HEADERS = {
  Authorization: `Basic ${AUTH}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
}

// Map numeric state codes to human-readable labels
const STATE_LABELS = {
  '1': 'New',
  '2': 'In Progress',
  '3': 'On Hold',
  '6': 'Resolved',
  '7': 'Closed',
  '8': 'Cancelled',
}

function stateLabel(code) {
  return STATE_LABELS[String(code)] || `State ${code}`
}

async function snowFetch(path, options = {}) {
  const url = `${BASE}/api/now${path}`
  const res = await fetch(url, { ...options, headers: { ...HEADERS, ...options.headers } })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ServiceNow API error ${res.status}: ${text}`)
  }
  return res.json()
}

export async function getTickets() {
  const data = await snowFetch(
    '/table/incident?sysparm_query=caller_id.user_name%3D' +
    encodeURIComponent(process.env.SERVICENOW_USERNAME) +
    '%5EORDERBYDESCsys_created_on&sysparm_limit=20' +
    '&sysparm_fields=number,short_description,state,priority,assigned_to,sys_created_on'
  )
  return (data.result || []).map(t => ({
    number: t.number,
    short_description: t.short_description,
    state: stateLabel(t.state),
    priority: t.priority,
    assigned_to: t.assigned_to?.display_value || null,
    created: t.sys_created_on,
  }))
}

export async function createTicket({ description, caller = 'Voice Assistant User' }) {
  const data = await snowFetch('/table/incident', {
    method: 'POST',
    body: JSON.stringify({
      short_description: description,
      description: `Created via ServiceNow Voice Assistant. Caller: ${caller}`,
      urgency: '3',
      impact: '3',
      category: 'inquiry',
    }),
  })
  const t = data.result
  return {
    number: t.number,
    sys_id: t.sys_id,
    short_description: t.short_description,
    state: stateLabel(t.state),
  }
}

export async function resolveTicket({ ticketNumber }) {
  // First look up the sys_id from the ticket number
  const lookup = await snowFetch(
    `/table/incident?sysparm_query=number=${encodeURIComponent(ticketNumber)}&sysparm_fields=sys_id`
  )
  const record = lookup.result?.[0]
  if (!record) throw new Error(`Ticket ${ticketNumber} not found`)

  const data = await snowFetch(`/table/incident/${record.sys_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      state: '6', // Resolved
      close_code: 'Solved (Permanently)',
      close_notes: 'Resolved via ServiceNow Voice Assistant.',
    }),
  })
  return data.result
}

export async function updateTicket({ ticketNumber, comment }) {
  const lookup = await snowFetch(
    `/table/incident?sysparm_query=number=${encodeURIComponent(ticketNumber)}&sysparm_fields=sys_id`
  )
  const record = lookup.result?.[0]
  if (!record) throw new Error(`Ticket ${ticketNumber} not found`)

  const data = await snowFetch(`/table/incident/${record.sys_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      comments: comment,
    }),
  })
  return data.result
}

export async function getTicketStatus({ ticketNumber }) {
  const data = await snowFetch(
    `/table/incident?sysparm_query=number=${encodeURIComponent(ticketNumber)}` +
    '&sysparm_fields=number,short_description,state,priority,assigned_to,sys_created_on'
  )
  const t = data.result?.[0]
  if (!t) throw new Error(`Ticket ${ticketNumber} not found`)
  return {
    number: t.number,
    short_description: t.short_description,
    state: stateLabel(t.state),
    priority: t.priority,
    assigned_to: t.assigned_to?.display_value || null,
  }
}
