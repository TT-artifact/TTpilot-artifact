FROM python:3.11-alpine

RUN apk add --no-cache git

WORKDIR /app
ARG BRANCH=v1.18.4
RUN git clone https://github.com/9001/copyparty.git /app
RUN git checkout ${BRANCH}

# Install from PyPI to get pre-built webdeps, copy them into source tree
RUN pip install --no-cache-dir copyparty==1.18.4 && \
    cp -r "$(find /usr/local/lib -path '*/copyparty/web/deps' -type d | head -1)" /tmp/webdeps && \
    pip install --no-cache-dir -e . && \
    cp -r /tmp/webdeps/* /app/copyparty/web/deps/

EXPOSE 8080
CMD ["python", "-m", "copyparty", "-p", "8080", "--no-crt"]
