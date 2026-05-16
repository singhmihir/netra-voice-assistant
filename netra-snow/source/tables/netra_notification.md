# Table: `__NETRA_SCOPE___notification`

Queue of unread Netra notifications, one row per event. The widget polls
`/api/__NETRA_SCOPE__/voice/notifications`, which returns and marks each row as
delivered.

## Schema

| Column         | Type         | Length | Notes                                            |
|----------------|--------------|--------|--------------------------------------------------|
| `user`         | Reference    | sys_user | Who should hear this                            |
| `ticket_sys_id`| String       | 32     | sys_id of the related incident                   |
| `ticket_number`| String       | 32     | e.g. INC0001234                                  |
| `kind`         | String       | 40     | `comment`, `work_note`, `state_change`           |
| `message`      | String       | 1000   | Spoken text                                      |
| `delivered`    | True/False   | —      | Default: false                                   |
| `delivered_at` | Date/Time    | —      | Set when consumed                                |

ServiceNow auto-creates `sys_id`, `sys_created_on`, `sys_updated_on`, etc.

## Manual creation (if not importing via Update Set)

1. **System Definition → Tables → New**
2. Label: **Netra Notification**, Name: `__NETRA_SCOPE___notification`
3. Application: **Netra Voice Assistant** (`__NETRA_SCOPE__`)
4. Add the columns above via the Form Designer
5. Save
