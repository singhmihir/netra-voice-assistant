import { NextResponse } from 'next/server'
import { updateTicket } from '../../../../lib/servicenow'

export async function POST(request) {
  try {
    const { ticketNumber, comment } = await request.json()
    const result = await updateTicket({ ticketNumber, comment })
    return NextResponse.json({ result })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
