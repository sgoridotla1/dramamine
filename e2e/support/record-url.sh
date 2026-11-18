#!/bin/sh
# Test stand-in for Chrome: the MCP server "opens" the consent URL by writing it to $STR_URL_FILE.
echo "$1" >> "$STR_URL_FILE"
