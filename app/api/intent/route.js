import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createTicket, resolveTicket, updateTicket, getTickets, getTicketStatus } from '../../../lib/servicenow'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are an intent classifier for a ServiceNow voice assistant used by blind users.
Analyze the user's spoken command and return ONLY valid JSON with this shape:
{
  "intent": "create_ticket" | "list_tickets" | "resolve_ticket" | "update_ticket" | "ticket_status" | "unknown",
  "ticket_number": "<INC or RITM number if mentioned, else null>",
  "description": "<description of the issue for create_ticket, else null>",
  "comment": "<comment text for update_ticket, else null>"
}

Rules:
- For create_ticket, extract the problem description from the user's words.
- For resolve_ticket / update_ticket / ticket_status, extract the ticket number (e.g. INC0001234).
- If the intent is unclear, use "unknown".
- Return ONLY the JSON object, no other text.`

export async function POST(request) {
  try {
    const { text } = await request.json()
    if (!text) {
      return NextResponse.json({ error: 'No text provided' }, { status: 400 })
    }

    // Ask Claude to classify intent
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    })

    let parsed
    try {
      parsed = JSON.parse(msg.content[0].text.trim())
    } catch {
      return NextResponse.json({
        success: false,
        message: "I didn't understand that command. Please try again. You can say things like: create a ticket for my laptop is broken, list tickets, or resolve ticket INC0001234.",
        refreshTickets: false,
      })
    }

    const { intent, ticket_number, description, comment } = parsed

    // Execute the action
    switch (intent) {
      case 'create_ticket': {
        if (!description) {
          return NextResponse.json({
            success: false,
            message: 'Please describe the issue you want to report. For example: create a ticket for my email is not working.',
            refreshTickets: false,
          })
        }
        const ticket = await createTicket({ description, caller: 'Voice Assistant User' })
        return NextResponse.json({
          success: true,
          message: `Ticket created successfully. Your ticket number is ${ticket.number}. The issue recorded is: ${description}.`,
          refreshTickets: true,
        })
      }

      case 'list_tickets': {
        const tickets = await getTickets()
        if (tickets.length === 0) {
          return NextResponse.json({
            success: true,
            message: 'You have no open tickets at this time.',
            refreshTickets: true,
          })
        }
        const summary = tickets.slice(0, 5).map(t =>
          `${t.number}: ${t.short_description}, state ${t.state}`
        ).join('. ')
        return NextResponse.json({
          success: true,
          message: `You have ${tickets.length} open ticket${tickets.length === 1 ? '' : 's'}. Here are the most recent: ${summary}. The ticket list on screen has been refreshed.`,
          refreshTickets: true,
        })
      }

      case 'resolve_ticket': {
        if (!ticket_number) {
          return NextResponse.json({
            success: false,
            message: 'Please say the ticket number you want to resolve. For example: resolve ticket INC0001234.',
            refreshTickets: false,
          })
        }
        await resolveTicket({ ticketNumber: ticket_number })
        return NextResponse.json({
          success: true,
          message: `Ticket ${ticket_number} has been resolved successfully. The issue is now closed.`,
          refreshTickets: true,
        })
      }

      case 'update_ticket': {
        if (!ticket_number || !comment) {
          return NextResponse.json({
            success: false,
            message: 'Please say the ticket number and your update. For example: update ticket INC0001234 with I have restarted the system and it is still broken.',
            refreshTickets: false,
          })
        }
        await updateTicket({ ticketNumber: ticket_number, comment })
        return NextResponse.json({
          success: true,
          message: `Ticket ${ticket_number} has been updated with your comment: ${comment}.`,
          refreshTickets: true,
        })
      }

      case 'ticket_status': {
        if (!ticket_number) {
          return NextResponse.json({
            success: false,
            message: 'Please say the ticket number. For example: what is the status of ticket INC0001234.',
            refreshTickets: false,
          })
        }
        const info = await getTicketStatus({ ticketNumber: ticket_number })
        return NextResponse.json({
          success: true,
          message: `Ticket ${ticket_number}: ${info.short_description}. Current state is ${info.state}. Priority is ${info.priority}. Assigned to ${info.assigned_to || 'no one yet'}.`,
          refreshTickets: false,
        })
      }

      default:
        return NextResponse.json({
          success: false,
          message: "I'm not sure what you want to do. You can say: create a ticket, list tickets, resolve a ticket, update a ticket, or ask for a ticket's status.",
          refreshTickets: false,
        })
    }
  } catch (err) {
    console.error('[intent]', err)
    return NextResponse.json(
      { success: false, message: `An error occurred: ${err.message}`, refreshTickets: false },
      { status: 500 }
    )
  }
}
