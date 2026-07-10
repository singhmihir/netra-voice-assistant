# Table: `__NETRA_SCOPE___context`

Per-user conversational context. Lets Netra interpret pronouns like "that
ticket", "resolve it", "read it again" by remembering the last entity the
user focused on. Created on demand; one row per user.

## Schema

| Column           | Type                  | Notes                                          |
|------------------|-----------------------|------------------------------------------------|
| `user`           | Reference → sys_user  | Indexed, unique                                |
| `focus_table`    | String (40)           | Last table mentioned (e.g. `incident`)         |
| `focus_sys_id`   | String (32)           | Last record sys_id                             |
| `focus_number`   | String (32)           | Display number (e.g. INC0001234, KB0010001)    |
| `focus_set_at`   | Date/Time             | When the focus was set (TTL = 12 h)            |
| `last_utterance` | String (250,000)      | 'CTX:'-prefixed JSON blob: draft, memory, vocab, aliases, sentiment - plus the last spoken reply (for "repeat that") |
