import { NextResponse } from 'next/server'
import { resolveTicket } from '../../../../lib/servicenow'

export async function POST(request) {
  try {
    const { ticketNumber } = await request.json()
    const result = await resolveTicket({ ticketNumber })
    return NextResponse.json({ result })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
