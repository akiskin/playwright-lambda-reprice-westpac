ARG FUNCTION_DIR="/function"

FROM mcr.microsoft.com/playwright:v1.21.0-focal as build-image

ARG FUNCTION_DIR

RUN apt update && apt upgrade -y && apt install -y g++ make cmake unzip libcurl4-openssl-dev libtool autoconf
RUN mkdir -p ${FUNCTION_DIR}
WORKDIR ${FUNCTION_DIR}
RUN npm install aws-lambda-ric
COPY src/* ${FUNCTION_DIR}
RUN npm install playwright@1.21.0 @aws-sdk/client-s3


# Grab a fresh slim copy of the image to reduce the final size
FROM mcr.microsoft.com/playwright:v1.21.0-focal

# Include global arg in this stage of the build
ARG FUNCTION_DIR

# Set working directory to function root directory
WORKDIR ${FUNCTION_DIR}

# Copy in the built dependencies
COPY --from=build-image ${FUNCTION_DIR} ${FUNCTION_DIR}


ENTRYPOINT ["/usr/bin/npx", "aws-lambda-ric"]
CMD ["app.handler"]
