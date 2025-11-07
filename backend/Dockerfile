# Use a specific, stable Alpine version
FROM alpine:3.20

# Set a working directory
WORKDIR /app

#
# --- THIS IS THE FIX ---
#
# Enable the 'community' repository by uncommenting the correct line
# in the repositories file. Then update the package list.
#
RUN sed -i 's/^#\(.*\/v3.20\/community\)$/\1/' /etc/apk/repositories && \
    apk update && \
    apk add yosys