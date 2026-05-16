# Table: `x_196061_netra_notification`

Queue of unread Netra notifications, one row per event. The widget polls
`/api/x_196061_netra/voice/notifications`, which returns and marks each row as
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
2. Label: **Netra Notification**, Name: `x_196061_netra_notification`
3. Application: **Netra Voice Assistant** (`x_196061_netra`)
4. Add the columns above via the Form Designer
5. Save
