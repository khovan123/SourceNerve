FROM rust:1.88-bookworm AS build
ARG SOURCENERVE_BUILD_COMMIT=unknown
WORKDIR /app
COPY . .
RUN SOURCENERVE_BUILD_COMMIT="$SOURCENERVE_BUILD_COMMIT" cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git gh ripgrep && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home sourcenerve
COPY --from=build /app/target/release/sourcenerve /usr/local/bin/sourcenerve
USER sourcenerve
EXPOSE 7331
ENTRYPOINT ["/usr/local/bin/sourcenerve"]
