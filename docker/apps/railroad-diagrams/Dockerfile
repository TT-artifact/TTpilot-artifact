FROM node:20-alpine

RUN apk add --no-cache git
RUN npm install -g http-server

WORKDIR /app
ARG BRANCH=ea9a123
RUN git clone https://github.com/tabatkins/railroad-diagrams.git /app
RUN git checkout ${BRANCH}

EXPOSE 8080
CMD ["http-server", ".", "-p", "8080", "-a", "0.0.0.0"]
