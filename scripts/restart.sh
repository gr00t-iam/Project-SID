#!/usr/bin/env bash
set -euo pipefail
systemctl restart sid-local.service
systemctl --no-pager --full status sid-local.service
