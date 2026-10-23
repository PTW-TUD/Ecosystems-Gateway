build-publishing-connector:
    docker buildx build \
        -t registry.euprogigant.kube.a1.digital/sebastian.waldbauer/publishing-connector/publishing_connector:dev \
        --provenance=false \
        --platform linux/amd64,linux/arm64 \
        .

publish-publishing-connector:
    docker login registry.euprogigant.kube.a1.digital
    docker push registry.euprogigant.kube.a1.digital/sebastian.waldbauer/publishing-connector/publishing_connector:dev

build-protobuf:
    npm run proto:gen

grpc-call:
    grpc_cli ls 127.0.0.1:5002 -l
    grpc_cli call 127.0.0.1:5002 eupg.ecosystemsgateway.v3.ecosystemsgateway.RunComputeToDataJob "did: 'did:ope:...', algorithm: 'did:ope:...'"
