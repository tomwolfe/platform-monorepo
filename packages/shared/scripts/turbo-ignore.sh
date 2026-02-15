#!/bin/bash

# turbo-ignore.sh
# Shared script to determine if a build is necessary based on git changes
# Uses turbo ls --filter to check if current package has changes

set -e

# Get the current package name from package.json
PACKAGE_NAME=$(cat package.json | grep '"name"' | head -1 | cut -d'"' -f4)

if [ -z "$PACKAGE_NAME" ]; then
  echo "Error: Could not determine package name from package.json"
  exit 1
fi

echo "Checking if $PACKAGE_NAME has changes..."

# Check if this is a Vercel deployment
if [ -n "$VERCEL" ]; then
  # In Vercel, check against the previous deployment
  if [ -n "$VERCEL_GIT_PREVIOUS_SHA" ]; then
    PREVIOUS_SHA="$VERCEL_GIT_PREVIOUS_SHA"
  else
    # Try to get the parent commit
    PREVIOUS_SHA=$(git rev-parse HEAD^ 2>/dev/null || echo "")
  fi
else
  # Local development - check against main branch
  PREVIOUS_SHA=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo "HEAD~1")
fi

if [ -z "$PREVIOUS_SHA" ]; then
  echo "No previous commit found, proceeding with build"
  exit 1
fi

# Use turbo to check if this package or its dependencies have changes
# Returns 0 if there are changes (build needed), 1 if no changes (skip build)
if npx turbo ls --filter="${PACKAGE_NAME}...[${PREVIOUS_SHA}]" --output=json 2>/dev/null | grep -q "packages\|apps"; then
  echo "Changes detected in $PACKAGE_NAME or its dependencies - build required"
  exit 1
else
  echo "No changes detected in $PACKAGE_NAME or its dependencies - skipping build"
  exit 0
fi
