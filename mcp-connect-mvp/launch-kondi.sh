#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 22
cd /home/erik/Documents/MCP_Connector_App/mcp-connect-mvp
exec npm run tauri dev 2>&1 | tee /tmp/kondi.log
