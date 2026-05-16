# Table: `__NETRA_SCOPE___user_pref`

Per-user preferences for Netra. One row per user the first time they load
the widget. Used by:
- Server: `NetraScanner` (to iterate users + know last-scanned time + respect pause)
- Server: `NetraTools.pauseNotifications()` / `resumeNotifications()`
- Server: `/api/__NETRA_SCOPE__/voice/notifications` (skips polling while paused)

## Schema

| Column              | Type                  | Notes                                              |
|---------------------|-----------------------|----------------------------------------------------|
| `user`              | Reference → sys_user  | Indexed, unique (one row per user)                 |
| `active`            | True/False, default true | Soft-disable without deleting                   |
| `paused_until`      | Date/Time             | NULL = not paused. Otherwise an absolute UTC time. |
| `last_scan_time`    | Date/Time             | Watermark used by NetraScanner                     |
| `watch_assignments` | True/False, default true | Notify about new incident/change/sc_task assignments |
| `watch_comments`    | True/False, default true | Notify about new ticket comments                |
| `watch_approvals`   | True/False, default true | Notify about pending approvals                  |

Auto: `sys_id`, `sys_created_on`, `sys_updated_on`, `sys_created_by`, `sys_updated_by`.
