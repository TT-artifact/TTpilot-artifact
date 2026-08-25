FROM node:20-alpine

RUN apk add --no-cache git
RUN npm install -g http-server

WORKDIR /app
ARG BRANCH=v20.5.0
RUN git clone https://github.com/jgraph/drawio.git /app
RUN git checkout ${BRANCH}

# draw.io static web app root is src/main/webapp/
WORKDIR /app/src/main/webapp

EXPOSE 8080
CMD ["http-server", ".", "-p", "8080", "-a", "0.0.0.0"]
