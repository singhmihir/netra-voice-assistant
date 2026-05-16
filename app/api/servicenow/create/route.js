import { NextResponse } from 'next/server'
import { createTicket } from '../../../../lib/servicenow'

export async function POST(request) {
  try {
    const body = await request.json()
    const ticket = await createTicket(body)
    return NextResponse.json({ ticket })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
