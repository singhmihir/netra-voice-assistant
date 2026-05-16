# Table: `__NETRA_SCOPE___watchlist`

Records the user wants proactive alerts on, even if they are not the caller
or assignee. NetraScanner consults this table on its periodic run.

## Schema

| Column          | Type                  | Notes                                |
|-----------------|-----------------------|--------------------------------------|
| `user`          | Reference → sys_user  | Indexed                              |
| `record_table`  | String (40)           | e.g. `incident`, `change_request`    |
| `record_sys_id` | String (32)           | The watched record's sys_id          |
| `record_number` | String (32)           | Display number for spoken playback   |
