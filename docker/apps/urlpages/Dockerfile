FROM node:20-alpine

RUN apk add --no-cache git
RUN npm install -g http-server

WORKDIR /app
ARG BRANCH=035b647
RUN git clone https://github.com/jstrieb/urlpages.git /app
RUN git checkout ${BRANCH}

EXPOSE 8080
CMD ["http-server", ".", "-p", "8080", "-a", "0.0.0.0"]
