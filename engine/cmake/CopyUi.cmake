# Copies the built console UI into the app. Warns (doesn't fail) if it hasn't been built.
if(EXISTS "${SRC}/index.html")
  file(REMOVE_RECURSE "${DEST}")
  file(COPY "${SRC}/" DESTINATION "${DEST}")
  message(STATUS "Merge: bundled console UI into ${DEST}")
else()
  message(WARNING "Merge: console UI not built (${SRC}/index.html missing). Run 'npm install && npm run build' in the repo root, then rebuild.")
endif()
