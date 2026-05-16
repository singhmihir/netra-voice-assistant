import { NextResponse } from 'next/server'
import { getTickets } from '../../../../lib/servicenow'

export async function GET() {
  try {
    const tickets = await getTickets()
    return NextResponse.json({ tickets })
  } catch (err) {
    console.error('[tickets]', err)
    return NextResponse.json({ error: err.message, tickets: [] }, { status: 500 })
  }
}
