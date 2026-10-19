package corpus

#Service: {
	name:     string
	port:     int & >=1024 & <=65535
	replicas: *1 | int
	labels?: [string]: string
}

services: [Name=string]: #Service & {
	name: Name
}

services: web: {
	port:     8080
	replicas: 3
	labels: tier: "frontend"
}

services: db: port: 5432

summary: [for n, s in services {"\(n):\(s.port)"}]
