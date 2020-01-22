# TILEDESK LOCALHOST REST API

## Signup

```
curl -v -X POST -d 'email=redacted@example.invalid&password=123456' http://localhost:3000/auth/signup

curl -v -X POST -d 'email=redacted@example.invalid&password=123456' https://tiledesk-server-pre.herokuapp.com/auth/signup
```


## Signin

```
curl -v -X POST -d 'email=redacted@example.invalid&password=123456' http://localhost:3000/auth/signin

curl -v -X POST -d 'email=redacted@example.invalid&password=123456' https://tiledesk-server-pre.herokuapp.com/auth/signin
```


## Signin anonymously

```
curl -v -X POST -H 'Content-Type:application/json' -d '{"firstname":"Andrew", "lastname":"Lee", "id_project":"123"}' http://localhost:3000/auth/signinAnonymously
```

curl -v -X POST -H 'Content-Type:application/json' -d '{"id_project":"5e28108c361fbb001729e960"}' https://tiledesk-server-pre.herokuapp.com/auth/signinAnonymously


## Signin custom token


{
  "_id": "123456",
  "firstname": "andrea custom",
  "lastname": "leo custom",
  "email": "redacted@example.invalid",
  "custom1": "val1",
  "attributes": {"c1":"v1"},
  "sub": "userexternal",
  "aud": "https://tiledesk.com/projects/5e28108c361fbb001729e960"
}


custom project secret: REDACTED_SECRET

generato su https://jwt.io/

https://jwt.io/

[REDACTED_JWT]


curl -v -X POST -H 'Content-Type:application/json' \
 -H "Authorization: JWT [REDACTED_JWT]" \
 https://tiledesk-server-pre.herokuapp.com/auth/signinWithCustomToken






## Firebase signin

```
curl -v -X POST -d 'email=redacted@example.invalid&password=123456' http://localhost:3000/firebase/auth/signin
```

## Firebase createtoken

```
curl -v -X POST -u redacted@example.invalid:123456 http://localhost:3000/firebase/createtoken
```

## Projects

### Create

```
curl -v -X POST -H 'Content-Type:application/json' -u redacted@example.invalid:123456 -d '{"name":"testprj"}' http://localhost:3000/projects
```


## Messages 



### Create 

```
curl -v -X POST -H 'Content-Type:application/json' -u redacted@example.invalid:123456 -d '{"sender":"io", "sender_fullname":"Andrea Leo", "text":"firstText"}' http://localhost:3000/5ca366fdee19dbc72e98e96f/requests/req123456/messages
```

curl -v -X POST -H 'Content-Type:application/json' -u redacted@example.invalid:258456 -d '{"text":"firstText22"}' https://tiledesk-server-pre.herokuapp.com/5df2240cecd41b00173a06bb/requests/support-group-5544/messages


curl -v -X POST -H 'Content-Type:application/json' -u redacted@example.invalid:a7de28c6-d309-4539-9749-43dd4535fa7c -d '{"text":"firstText22"}' https://tiledesk-server-pre.herokuapp.com/5df2240cecd41b00173a06bb/requests/support-group-554477991/messages


con anonym user
curl -v -X POST -H 'Content-Type:application/json' \
 -H "Authorization: JWT [REDACTED_JWT]" \
 -d '{"text":"firstTextAnon"}' https://tiledesk-server-pre.herokuapp.com/5e28108c361fbb001729e960/requests/support-group-55447799177/messages

con ct user:

curl -v -X POST -H 'Content-Type:application/json' \
 -H "Authorization: JWT [REDACTED_JWT]" \
 -d '{"text":"firstTextCT"}' https://tiledesk-server-pre.herokuapp.com/5e28108c361fbb001729e960/requests/support-group-5544779917789/messages




### Get
```
smessages/5beeb3835d34344cd4962a8c
```




## Requests 

### Create 



### List

```
curl -v -X GET -H 'Content-Type:application/json' -u redacted@example.invalid:123456 http://localhost:3000/5bedbbd18b9ed53a6a3f3dd3/requests/req123456/
```


### Get

```

### List

```
curl -v -X GET -H 'Content-Type:application/json' -u redacted@example.invalid:123456 http://localhost:3000/5ab0f32757066e0014bfd718/requests/
```


### Patch 

```
curl -v -X PATCH -H 'Content-Type:application/json' -u redacted@example.invalid:123456 -d '{"rating":5, "rating_message":"Great"}' http://localhost:3000/5ab0f32757066e0014bfd718/requests/5b800a7f52ee93a525ca0d8c
```

### Share by email
```
curl -v -X POST -H 'Content-Type:application/json' -u redacted@example.invalid:123456 [REDACTED_BASIC_AUTH_URL]
```

## Departments 

### Create 

```
curl -v -X POST -H 'Content-Type:application/json' -u redacted@example.invalid:123456 -d '{"name":"testdepartment","id_bot":"idbot"}' http://localhost:3000/5ab0f32757066e0014bfd718/departments
```

### List

```
curl -v -X GET -u redacted@example.invalid:123456 http://localhost:3000/5ab0f32757066e0014bfd718/departments
```

### Create a default department

```
curl -v -X POST -H 'Content-Type:application/json' -u redacted@example.invalid:123456 -d '{"name":"default","id_bot":"","default":true}' http://localhost:3000/5ab0f32757066e0014bfd718/departments
```

### Get default department

```
curl -v -X GET -u redacted@example.invalid:123456 http://localhost:3000/5ab0f32757066e0014bfd718/departments/default
```

### Get the available operator for a specific department
```
curl -X GET -u redacted@example.invalid:123456 http://localhost:3000/5ad706aa7009f70267089951/departments/5ad706db7009f70267089955/operators
```

## Bots 

### List

```
curl -v -X GET -u redacted@example.invalid:123456 http://localhost:3000/5ab0f32757066e0014bfd718/faq_kb
```

#### Create

```
curl -v -X POST -H 'Content-Type:application/json' -u redacted@example.invalid:123456 -d '{"name":"testbot"}' http://localhost:3000/5bedbbd18b9ed53a6a3f3dd3/faq_kb
```


### ASK

```
curl -v -X POST  -H 'Content-Type:application/json' -u redacted@example.invalid:123456 -d '{"question":"test","doctype":"normal","min_score":"0.0","remote_faqkb_key":"c9970cc1-a211-4390-b7d0-cdf154d464a9"}' http://localhost:3000/5bedbbd18b9ed53a6a3f3dd3/faq/askbot
```


## WebHook Subscription

### Create
```
curl -v -X POST -H 'Content-Type:application/json' -u redacted@example.invalid:123456 -d '{"event":"message.create", "target":"https://tiledesk.requestcatcher.com/test"}' http://localhost:3000/5bedbbd18b9ed53a6a3f3dd3/subscriptions
```



