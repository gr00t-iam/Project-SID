# Historical maintenance tools

These are one-time diagnostics and supervised repair tools used during the October 9 settlement work. Some inspect blocks; others move citizens, withdraw materials, place blocks or edit persisted state. They depend on the original settlement coordinates, Node paths and runtime state schema. Review each script before use. They do not run during normal startup or build.

Credentials are read from environment variables and are not included. World state, intermediate snapshots, personal records and deployment-specific authentication files are omitted.
