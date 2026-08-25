FROM node:20-alpine

RUN apk add --no-cache git python3 make g++
RUN npm install -g http-server

WORKDIR /app
ARG BRANCH=1.111
RUN git clone https://github.com/CesiumGS/cesium.git /app
RUN git checkout ${BRANCH}

# Install dependencies and build CesiumJS
RUN npm install --ignore-scripts 2>&1
RUN npx gulp build 2>&1

EXPOSE 8080
CMD ["http-server", ".", "-p", "8080", "-a", "0.0.0.0"]
