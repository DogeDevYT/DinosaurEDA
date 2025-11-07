# Use a small, minimal base image
FROM alpine:latest

# Install yosys (our compiler)
# 'apk add' is the package manager for Alpine Linux
RUN apk update && apk add yosys

# Set a working directory inside the container
WORKDIR /app