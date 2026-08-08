# Admin Dashboard

## Instance

### Overview

No changes in current state

### Settings

#### General Tab

- When I change the appearance the neutral swatch button changes color to what ever color I chose

#### Authentication Tab

- when "Allow email and password sign-in" is disabled does the auth form disapear ?

#### Email & SMTP tab

- Ability to send a test email
- Are there email templates

### Branding

- I can change the name of the app but can I also change the place where it says "OCI" in the side bar
- I can set a logo url, can I upload a file too.  will this logo be used in the login and in the sidebar.  i would also like the sidebar
- can we add a new user on boarding, that way we ask question to help personalize the experiance when user first log in?  this is to get and verifi information and for also show things like an acceptable use policy and getting them to verify they read it

## People

### Users

- looks good but adding the ability to use filters and making the table sortable would be nice

### Invitations

- no changes at this time

### Auth & SSO

- I would like the ability to assign app role based on information passed in through SSO.  not sure if this would be groups or roles via OIDC and SAML

## Models

### Providers & Keys

- no changes for now

### Model Catalog

- In edit/add model modal, I want to remove Cost Teir, Context Window, Max Output
- the Lab dropdown box look like a system not shadcn one. same for providers
- Default model should be set in system setting not in the model catalog. move it to the general tab

## Governance

### Rate limits

- can By role and Reservations be tabs instead of on the same page

## Platform

### Storage

- Storage driver, S3 connection, and Upload policy should be seperate tabs
- Dropdown look like system ones instead of Shadcn style, lets fix this at large in the app
- When local File system, I can't set path in the application ui

## NEW STUFF

- I would like to add a message/broadcast system so admin can notify user of up cming changes
- I would like to be able to set some syste settings via a config file, env settings, or the UI.  lets review this and figure out what make since