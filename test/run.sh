#!/bin/bash
BASEDIR=$(dirname $0)
FILES=$BASEDIR/*_test.js
for f in $FILES
do
  echo "====== Running $f..."
  ./node_modules/.bin/mocha $f
  sleep 3
done