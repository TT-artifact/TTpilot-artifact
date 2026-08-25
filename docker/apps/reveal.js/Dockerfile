FROM node:18-alpine

RUN apk add --no-cache git
RUN npm install -g http-server

WORKDIR /app
ARG BRANCH=4.2.1
RUN git clone https://github.com/hakimel/reveal.js.git /app
RUN git checkout ${BRANCH}
RUN npm install && npm run build

EXPOSE 8080
CMD ["http-server", ".", "-p", "8080", "-a", "0.0.0.0"]
