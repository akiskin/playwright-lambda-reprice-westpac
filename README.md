# Build Lambda Image and Test Locally

```
docker build -t nab-playwright-ms .
```

```
docker run -d -v ~/.aws-lambda-rie:/aws-lambda -p 9009:8080 \
	-e AWS_ACCESS_KEY_ID='...' \
	-e AWS_SECRET_ACCESS_KEY='...' \
    --entrypoint /aws-lambda/aws-lambda-rie \
    nab-playwright-ms \
        /usr/bin/npx aws-lambda-ric app.handler
```
		
```
curl -X POST "http://localhost:9009/2015-03-31/functions/function/invocations" -H "Content-type: application/json" -d '{"credentials": {"username": "...", "password": "..."}}'
```

# Pushing to AWS

```
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin <AWS ECR URI>
```

```
docker build -t nab-playwright-ms .
```

```
docker tag nab-playwright-ms <AWS ECR URI>/<HUB>:latest
```

```
docker push <AWS ECR URI>/<HUB>:latest
```