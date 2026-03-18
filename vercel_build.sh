#!/bin/bash
set -e
echo "Starting build process..."
if [ -d "frontend" ]; then
  echo "Found 'frontend' directory."
  cd frontend
  npm install
  npm run build
  cd ..
  rm -rf dist
  cp -r frontend/dist dist
  echo "Copied frontend/dist to root dist"
elif [ -f "package.json" ]; then
  echo "Building from root..."
  npm install
  npm run build
fi
