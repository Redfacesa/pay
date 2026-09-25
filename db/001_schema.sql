-- Red Face payment terminal platform
-- PostgreSQL schema for the software platform.
-- Do not add columns for PAN, CVV, PIN, track, or other sensitive authentication data.

create table users (
  id text primary key,
  name text not null,
  email text not null unique,
  phone text not null default '',
  role text not null check (role in (
    'SUPER_ADMIN', 'ADMIN', 'OPERATIONS', 'FINANCE', 'SUPPORT', 'MERCHANT', 'TERMINAL'
  )),
  status text not null check (status in ('active', 'disabled')),
  created_at timestamptz not null default now()
);

create table businesses (
  id text primary key,
  owner_id text not null references users (id),
  business_name text not null,
  registration_number text not null default '',
  status text not null check (status in ('active', 'suspended')),
  currency text not null default 'ZAR',
  country text not null,
  created_at timestamptz not null default now()
);

create table merchant_accounts (
  id text primary key,
  business_id text not null references businesses (id),
  processor_id text not null,
  processor_account_id text not null,
  settlement_account text not null default '',
  status text not null check (status in ('active', 'pending', 'disabled'))
);

create table terminals (
  id text primary key,
  merchant_id text not null references merchant_accounts (id),
  terminal_serial text not null unique,
  device_model text not null,
  firmware_version text not null,
  software_version text not null,
  status text not null check (status in ('ONLINE', 'OFFLINE', 'UPDATING', 'LOCKED', 'DISABLED')),
  location text not null default '',
  config jsonb not null,
  pending_command jsonb,
  pairing_code text unique,
  last_seen timestamptz,
  registered_at timestamptz not null default now()
);

create table devices (
  id text primary key,
  terminal_id text not null references terminals (id),
  hardware_id text not null,
  os_version text not null,
  firmware_version text not null,
  app_version text not null,
  security_status text not null check (security_status in ('sandbox', 'revoked'))
);

create table orders (
  id text primary key,
  merchant_id text not null references merchant_accounts (id),
  customer_id text,
  subtotal integer not null check (subtotal >= 0),
  tax integer not null check (tax >= 0),
  discount integer not null check (discount >= 0),
  total integer not null check (total > 0),
  currency text not null,
  payment_status text not null check (payment_status in ('unpaid', 'paid', 'partial', 'refunded')),
  fulfillment_status text not null default 'not_applicable',
  created_at timestamptz not null default now()
);

create table transactions (
  id text primary key,
  merchant_id text not null references merchant_accounts (id),
  terminal_id text not null references terminals (id),
  order_id text not null references orders (id),
  session_id text,
  amount integer not null check (amount > 0),
  currency text not null,
  payment_method text not null check (payment_method in ('cash', 'card', 'tap', 'qr')),
  processor text not null,
  processor_reference text,
  status text not null check (status in (
    'CREATED', 'INITIATED', 'PROCESSING', 'AUTHORIZED', 'COMPLETED',
    'FAILED', 'DECLINED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'UNKNOWN'
  )),
  authorization_code text,
  refunded_amount integer not null default 0 check (refunded_amount >= 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table payment_sessions (
  id text primary key,
  merchant_id text not null references merchant_accounts (id),
  terminal_id text not null references terminals (id),
  order_id text not null references orders (id),
  transaction_id text not null references transactions (id),
  amount integer not null check (amount > 0),
  currency text not null,
  payment_method text not null,
  provider text not null,
  status text not null check (status in ('open', 'processing', 'completed', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table transactions
  add constraint transactions_session_fk
  foreign key (session_id) references payment_sessions (id);

create table refunds (
  id text primary key,
  transaction_id text not null references transactions (id),
  amount integer not null check (amount > 0),
  reason text not null,
  processor_reference text,
  status text not null check (status in ('completed', 'failed')),
  created_at timestamptz not null default now()
);

create table payment_events (
  id text primary key,
  transaction_id text not null references transactions (id),
  event_type text not null,
  payload jsonb not null,
  source text not null,
  timestamp timestamptz not null default now(),
  processed boolean not null default true
);

create table webhook_events (
  id text primary key,
  provider text not null,
  external_id text not null,
  event_type text not null,
  payload jsonb not null,
  processed boolean not null default false,
  received_at timestamptz not null default now(),
  unique (provider, external_id)
);

create table idempotency_keys (
  scope text not null,
  key text not null,
  request_hash text not null,
  state text not null check (state in ('pending', 'done')),
  transaction_id text references transactions (id),
  created_at timestamptz not null default now(),
  primary key (scope, key)
);

create table audit_logs (
  id text primary key,
  actor_id text not null,
  action text not null,
  resource text not null,
  resource_id text not null,
  metadata jsonb not null default '{}',
  timestamp timestamptz not null default now()
);

create table software_releases (
  id text primary key,
  version text not null,
  sha256 text not null,
  notes text not null,
  created_at timestamptz not null default now()
);

create table update_jobs (
  id text primary key,
  terminal_id text not null references terminals (id),
  release_id text not null references software_releases (id),
  version text not null,
  previous_version text not null,
  sha256 text not null,
  status text not null check (status in (
    'UPDATE_DETECTED', 'DOWNLOADING', 'DOWNLOADED', 'VERIFYING', 'VERIFIED',
    'INSTALLING', 'HEALTH_CHECK', 'COMPLETED', 'ROLLED_BACK'
  )),
  fail_health boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table terminal_logs (
  id text primary key,
  terminal_id text not null references terminals (id),
  level text not null check (level in ('info', 'warn')),
  message text not null,
  timestamp timestamptz not null default now()
);

create index transactions_merchant_created_idx on transactions (merchant_id, created_at desc);
create index transactions_terminal_created_idx on transactions (terminal_id, created_at desc);
create index transactions_processor_reference_idx on transactions (processor_reference);
create index payment_events_transaction_idx on payment_events (transaction_id, timestamp);
create index audit_logs_resource_idx on audit_logs (resource, resource_id, timestamp);
create index update_jobs_terminal_idx on update_jobs (terminal_id, created_at desc);
create index terminal_logs_terminal_idx on terminal_logs (terminal_id, timestamp desc);

create table service_orders (
  id text primary key,
  merchant_id text not null references merchant_accounts (id),
  terminal_id text not null references terminals (id),
  customer_reference text,
  service_type text not null check (service_type in ('AIRTIME', 'DATA', 'ELECTRICITY', 'VAS', 'SMS')),
  provider text not null,
  product_name text,
  network text,
  msisdn text,
  meter_number text,
  amount integer not null,
  cost integer not null default 0,
  margin integer not null default 0,
  currency text not null default 'ZAR',
  status text not null check (status in (
    'CREATED', 'SUBMITTED', 'PENDING', 'COMPLETED', 'FAILED', 'PROVIDER_ERROR', 'TIMEOUT'
  )),
  provider_reference text,
  provider_request_id text,
  voucher text,
  units text,
  failure_reason text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index service_orders_terminal_idx on service_orders (terminal_id, created_at desc);
