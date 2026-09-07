# Always-on utility container for every environment: Python 3 plus common CLI tools for an
# AI agent to debug/inspect/script against the other services (see toolbox-manager.js).
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        wget \
        git \
        vim \
        nano \
        less \
        jq \
        net-tools \
        iproute2 \
        iputils-ping \
        dnsutils \
        procps \
        htop \
        tree \
        unzip \
        openssh-client \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# No server process of its own; stay up so `docker exec`/execute-endpoint calls can reach it.
CMD ["sleep", "infinity"]
